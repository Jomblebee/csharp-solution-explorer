using MediatR;
using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Common.Interfaces;
using TaskFlow.Domain.Exceptions;

namespace TaskFlow.Application.Projects.Commands.DeleteProject;

public class DeleteProjectCommandHandler(ITaskFlowDbContext db)
    : IRequestHandler<DeleteProjectCommand>
{
    public async Task Handle(DeleteProjectCommand request, CancellationToken cancellationToken)
    {
        var project = await db.Projects.FindAsync([request.Id], cancellationToken)
            ?? throw new DomainException($"Project {request.Id} not found.");

        db.Projects.Remove(project);
        await db.SaveChangesAsync(cancellationToken);
    }
}
