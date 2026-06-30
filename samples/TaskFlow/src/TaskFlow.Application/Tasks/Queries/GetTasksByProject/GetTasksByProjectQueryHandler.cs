using MediatR;
using Microsoft.EntityFrameworkCore;
using TaskFlow.Application.Common.Interfaces;

namespace TaskFlow.Application.Tasks.Queries.GetTasksByProject;

public class GetTasksByProjectQueryHandler(ITaskFlowDbContext db)
    : IRequestHandler<GetTasksByProjectQuery, List<TaskDto>>
{
    public async Task<List<TaskDto>> Handle(GetTasksByProjectQuery request, CancellationToken cancellationToken)
    {
        return await db.Tasks
            .Where(t => t.ProjectId == request.ProjectId)
            .Select(t => new TaskDto(t.Id, t.Title, t.Description, t.Status, t.Priority))
            .ToListAsync(cancellationToken);
    }
}
